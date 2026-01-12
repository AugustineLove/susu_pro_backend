export const calculateLoan = (principal, annualRate, months, startDate, interestMethod) => {
    const monthlyRate = annualRate / 100 / 12;
    let totalInterest = 0;
    let monthlyPayment = 0;
    const schedule = [];
    if ( interestMethod === 'fixed' ) {
    // Fixed interest calculation: Interest = Principal * Rate
    totalInterest = principal * (annualRate / 100);
    monthlyPayment = (principal + totalInterest) / months;
    
    // For fixed loans, interest is the same regardless of months
    const monthlyPrincipal = principal / months;
    const monthlyInterest = totalInterest / months;
    let balance = principal;

    for (let month = 1; month <= months; month++) {
      balance -= monthlyPrincipal;
      schedule.push({
        month,
        payment: monthlyPayment,
        principal: monthlyPrincipal,
        interest: monthlyInterest,
        balance: Math.max(0, balance)
      });
    }
  }

    else if (interestMethod === 'reducing') {
      // Reducing balance method (EMI)
      monthlyPayment = principal * (monthlyRate * Math.pow(1 + monthlyRate, months)) / (Math.pow(1 + monthlyRate, months) - 1);
      
      let balance = principal;
      for (let month = 1; month <= months; month++) {
        const interestPayment = balance * monthlyRate;
        const principalPayment = monthlyPayment - interestPayment;
        balance -= principalPayment;
        totalInterest += interestPayment;

        schedule.push({
          month,
          payment: monthlyPayment,
          principal: principalPayment,
          interest: interestPayment,
          balance: Math.max(0, balance)
        });
      }
    } else {
      // Flat rate method
      totalInterest = principal * (annualRate / 100) * (months / 12);
      monthlyPayment = (principal + totalInterest) / months;
      
      const monthlyPrincipal = principal / months;
      const monthlyInterest = totalInterest / months;
      let balance = principal;

      for (let month = 1; month <= months; month++) {
        balance -= monthlyPrincipal;
        schedule.push({
          month,
          payment: monthlyPayment,
          principal: monthlyPrincipal,
          interest: monthlyInterest,
          balance: Math.max(0, balance)
        });
      }
    }

    // Calculate maturity date
    const maturityDate = new Date(startDate);
    maturityDate.setMonth(maturityDate.getMonth() + months);

    

    const totalRepayment = principal + totalInterest;
    const effectiveRate = (totalInterest / principal) * (12 / months) * 100;

    return totalRepayment

    // setFormData(prev => ({
    //   ...prev,
    //   maturityDate: maturityDate.toISOString().split('T')[0],
    //   monthlypayment: `${monthlyPayment}`,
    //   totalpayable: `${totalRepayment}`,
    //   amountpaid: '0',
    //   outstandingbalance: `${-totalRepayment}`
    // }));

    // setCalculations({
    //   totalInterest,
    //   totalRepayment,
    //   monthlyPayment,
    //   effectiveRate,
    //   maturityDate: maturityDate.toLocaleDateString(),
    //   paymentSchedule: schedule
    // });
  };